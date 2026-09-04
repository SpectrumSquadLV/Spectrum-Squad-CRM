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
    await page.waitForTimeout(1400);
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
    // Authorization dates belong to /authorization -- /api/clients/:id does not
    // accept them, by design, because editing them is a billing permission.
    const auth = async (id, body) => fetch(`/api/clients/${id}/authorization`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    await auth(a.id, { auth_start_date: dates.start, auth_expiration_date: dates.soon });
    await auth(b.id, { auth_expiration_date: dates.far });
    await auth(c.id, { auth_expiration_date: dates.mid });
    await set(a.id, { insurance_provider: "NV Medicaid" });
    await set(b.id, { insurance_provider: "Molina" });
    await set(c.id, { insurance_provider: "Aetna" });
    return { a: a.id, b: b.id, c: c.id };
  }, { start: iso(-120), soon: iso(4), mid: iso(20), far: iso(400), overdue: iso(-3) });
  check("test clients were created and assigned", !!made.a && !!made.b && !!made.c, made);

  // The Student Analyst is set through the migration's own path so the test
  // exercises what an admin will actually run, not a direct column write.
  await page.evaluate((d) => { window.__overdueDate = d; }, (() => {
    const p = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10).split("-");
    return `${p[1]}/${p[2]}/${p[0]}`;   // the sheet's own mm/dd/yyyy
  })());
  const mig = await page.evaluate(async () => {
    // Built from named columns rather than by counting pipes. Hand-writing the
    // row put the date in Auth End and the analyst in Tx Updates, which looked
    // plausible and tested nothing.
    const COLS = ["Client Name", "BCBA", "Insurance", "Auth Start", "Auth End",
                  "Treatment Plan Due", "Tx Updates", "Student Analyst", "Schedule"];
    const line = (o) => "| " + COLS.map((c) => o[c] || "").join(" | ") + " |";
    const text = [
      "| " + COLS.join(" | ") + " |",
      "| " + COLS.map(() => ":-:").join(" | ") + " |",
      line({ "Client Name": "Caseload Alpha", BCBA: "Clinical", "Treatment Plan Due": window.__overdueDate, "Student Analyst": "Intake" }),
      line({ "Client Name": "Caseload Beta", BCBA: "Clinical", "Student Analyst": "Intake" }),
      line({ "Client Name": "Nobody Real Here", BCBA: "Clinical", "Student Analyst": "Intake" }),
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

  // Checked here, in the session that is already open. A browser suite that
  // runs to the runner's limit starts failing for reasons that are not the
  // code's, and each extra sign-in costs several seconds.
  console.log("\n== An admin keeps their own dashboard ==");
  await page.goto(BASE + "/#/dashboard");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
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
  const cards = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".bd-card").forEach((c) => {
      const t = c.querySelector(".bd-ct"), n = c.querySelector(".bd-cn");
      if (t && n) out[t.textContent.trim()] = n.textContent.trim();
    });
    return out;
  });
  // The labels are uppercased by CSS, so this compares on the written text of
  // the element rather than on rendered innerText.
  const cardKeys = Object.keys(cards).map((k) => k.toLowerCase());
  // Matched on a distinctive fragment, not the whole label: the wording is a
  // design decision that will keep moving, but "there is a card about
  // authorizations" is the thing worth pinning.
  for (const t of ["clients", "authorizations expiring", "treatment plans due", "student analysts", "billable"]) {
    check(`the ${t} card is there`, cardKeys.some((k) => k.includes(t)), cardKeys);
  }
  const card = (name) => cards[Object.keys(cards).find((k) => k.toLowerCase().includes(name))];
  check("My Clients counts the assigned caseload", Number(card("clients")) >= 3, cards);
  check("an authorization 400 days out does NOT raise an alert",
    Number(card("authorizations expiring")) === 2, cards);
  check("an overdue treatment plan is counted", Number(card("treatment plans due")) >= 1, cards);
  check("billable says it is not available rather than showing 0%",
    /Not available/i.test(card("billable") || ""), card("billable"));

  console.log("\n== Authorizations ==");
  check("the authorizations panel is near the top",
    /Authorizations Expiring Soon/.test(text));
  const authHeads = await page.evaluate(() => {
    const p = [...document.querySelectorAll(".bd-panel")].find((t) => /Authorizations Expiring Soon/.test(t.textContent));
    return p ? [...p.querySelectorAll("th")].map((h) => h.textContent.trim().toLowerCase()) : [];
  });
  check("with the columns asked for",
    ["client", "payer", "auth start", "auth end", "days", "treatment plan due", "status"]
      .every((h) => authHeads.includes(h)), authHeads);
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
  const heads = caseload.heads.map((h) => h.toLowerCase());
  check("STUDENT ANALYST IS A COLUMN, not something behind a click",
    heads.includes("student analyst"), caseload.heads);
  check("and the other columns asked for are there",
    ["client", "status", "payer", "auth end", "treatment plan due", "next session"].every((h) => heads.includes(h)),
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

  console.log("\n== The Task Center a BCBA already had ==");
  // The regression this pins: replacing the generic dashboard for the clinical
  // role took the Task Center away from every BCBA. Its Completed tab and its
  // reopen have no equivalent on a simpler task list, so losing it lost real
  // function -- quietly, because a dashboard full of other panels still looks
  // complete.
  const tc = await page.evaluate(() => ({
    present: !!document.getElementById("task-center"),
    body: !!document.getElementById("task-center-body"),
    tabs: Array.from(document.querySelectorAll("[data-tc]")).map((b) => b.dataset.tc),
  }));
  check("THE BCBA DASHBOARD CARRIES THE REAL TASK CENTER", tc.present === true, tc);
  check("with all four tabs, Completed included",
    ["today", "upcoming", "overdue", "completed"].every((t) => tc.tabs.includes(t)), tc.tabs);
  check("and its body mounts", tc.body === true, tc);
  // It has to be the shell's own, not a copy: a second implementation is how
  // the two drift apart.
  check("mounted from the shell rather than rebuilt here",
    await page.evaluate(() => typeof window.__taskCenterHtml === "function" && typeof window.__fillTaskCenter === "function"));
  await page.evaluate(() => { const b = document.querySelector('[data-tc="completed"]'); if (b) b.click(); });
  await page.waitForTimeout(700);
  check("the Completed tab responds",
    await page.evaluate(() => !!document.querySelector('[data-tc="completed"].active')));

  console.log("\n== The rest of the page ==");
  check("the Student Analyst panel lists them with their clients", /My Student Analysts/.test(text));
  // Asked of the DOM at this moment, not of a snapshot taken near the top of the
  // run: the page has re-rendered several times since then, so a stale string is
  // testing what the dashboard looked like a minute ago.
  check("the task area is present",
    await page.locator("#task-center .section-title").count() === 1);
  check("Supervision is present", /Supervision/.test(text));
  check("and says the figures come from the tracker", /RBT Supervision tracker/i.test(text));
  check("the schedule panel names Rethink as the source",
    /source of truth for scheduling/i.test(text), text.match(/Rethink[^\n]*/));
  check("the schedule has day controls", await page.locator("[data-day]").count() === 3);
  for (const l of ["Treatment Plan Cheat Sheet", "Form Library", "Programming / BIP", "RBT Supervision", "Policies & SOPs", "Billable Requirements"]) {
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

  console.log("\n== Presentation ==");
  const html = await page.innerHTML(".bd");
  const emoji = html.match(/[\u{1F300}-\u{1FAFF}]/gu) || [];
  check("no emoji on the dashboard", emoji.length === 0, emoji);
  const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("nothing overflows horizontally", wide.doc <= wide.win + 1, wide);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(400);
  // On failure this names the WIDEST ELEMENT rather than only the page width.
  // "497 vs 480" says a page scrolls sideways; it does not say what is doing it,
  // and guessing at that has cost two runs already.
  const narrow = await page.evaluate(() => {
    const win = window.innerWidth;
    let worst = null;
    // Anything inside a scrolling container is EXCLUDED. A wide table in an
    // overflow-x:auto box sticks out of the viewport by design and scrolls
    // inside its own box -- reporting it hides the element that is actually
    // pushing the document, which is the only one worth fixing.
    const clipped = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      }
      return false;
    };
    document.querySelectorAll(".bd, .bd *").forEach((el) => {
      const r = el.getBoundingClientRect();
      const over = Math.round(r.right - win);
      if (over > 1 && !clipped(el) && (!worst || over > worst.over)) {
        worst = {
          over,
          tag: el.tagName.toLowerCase(),
          cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : String(el.className || "")).slice(0, 60),
          w: Math.round(r.width),
          text: (el.textContent || "").trim().slice(0, 40),
        };
      }
    });
    return { doc: document.documentElement.scrollWidth, win, worst };
  });
  check("nor on a phone", narrow.doc <= narrow.win + 1, narrow);

  console.log("\n== A role with no business here ==");
  await login("intake@spectrumsquadlv.com", "TestStaff123!");
  await page.goto(BASE + "/#/dashboard");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  check("intake does not get the caseload dashboard", await page.locator(".bd").count() === 0);
  const intakeMig = await page.evaluate(async () => (await fetch("/api/caseload/migration/preview", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "x" }),
  })).status);
  check("AND CANNOT RUN THE MIGRATION", intakeMig === 403, intakeMig);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
