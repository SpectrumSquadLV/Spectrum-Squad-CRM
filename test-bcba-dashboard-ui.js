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

  // A REAL COMPLETED TASK, against the real schema.
  //
  // The activity feed's query named staff_tasks.updated_at, which does not
  // exist -- the column is completed_at. It threw, the catch turned it into an
  // empty list, and completed tasks would have been missing from that panel
  // forever with nothing on screen or in any log to say so. The unit suite
  // stubs that query by shape and could never have caught it.
  const doneTask = await page.evaluate(async (clientId) => {
    const made = await (await fetch("/api/staff-tasks", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Draft the reauthorization packet", client_id: clientId,
                             assigned_name: "Clinical Staff" }),
    })).json();
    if (!made || !made.id) return { ok: false, made };
    const r = await fetch("/api/staff-tasks/" + made.id, {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    return { ok: r.ok, id: made.id };
  }, made.a);
  check("a task on the BCBA's client was created and completed", doneTask.ok === true, doneTask);

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
  check("and told what the page is for", /what needs your attention today/i.test(text));
  check("THERE IS NO 'PICK YOURSELF' DROPDOWN", await page.locator("#bd-pick").count() === 0);
  check("no separate BCBA Dashboard nav item was added",
    await page.locator('[data-nav="bcba-dashboard"]').count() === 0);

  console.log("\n== The clinical week ==");
  // The seven identical cards became a billable hero plus four compact tiles.
  // EVERY ASSERTION BELOW IS THE ONE IT ALWAYS WAS -- the same figures, the
  // same "not available rather than 0%" rule. Only where they are read from
  // moved, which is what a redesign is.
  const cards = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll(".bd-tile").forEach((c) => {
      const t = c.querySelector(".bd-tile-t"), n = c.querySelector(".bd-tile-n");
      if (t && n) out[t.textContent.trim()] = n.textContent.trim();
    });
    return out;
  });
  // The labels are uppercased by CSS, so this compares on the written text of
  // the element rather than on rendered innerText.
  const cardKeys = Object.keys(cards).map((k) => k.toLowerCase());
  // Matched on a distinctive fragment, not the whole label: the wording is a
  // design decision that will keep moving, but "there is a tile about
  // authorizations" is the thing worth pinning.
  for (const t of ["caseload", "authorizations", "treatment plans", "student analysts"]) {
    check(`the ${t} tile is there`, cardKeys.some((k) => k.includes(t)), cardKeys);
  }
  const card = (name) => cards[Object.keys(cards).find((k) => k.toLowerCase().includes(name))];
  check("My Clients counts the assigned caseload", Number(card("caseload")) >= 3, cards);
  check("an authorization 400 days out does NOT raise an alert",
    Number(card("authorizations")) === 2, cards);
  check("an overdue treatment plan is counted", Number(card("treatment plans")) >= 1, cards);

  const hero = await page.evaluate(() => {
    const h = document.querySelector(".bd-hero");
    return h ? { text: h.innerText, ring: h.querySelector(".bd-ring-n").textContent.trim(),
                 sweeps: h.querySelectorAll(".bd-ring svg circle").length } : null;
  });
  check("the billable figure has its own place at the top of the page", !!hero, hero);
  // THE RULE THAT SURVIVES EVERY REDESIGN. An unavailable figure is never
  // drawn as a percentage, and the ring gets no coloured sweep -- a full grey
  // circle at 0% says "you have done none of it", which is not what is true.
  check("billable says what is wrong rather than showing 0%",
    /Waiting on verification|Not linked|Not synced|Sync failed|Not configured|No weekly requirement|No staff record|Not available/i.test(hero.text),
    hero.text);
  check("...and its ring shows no percentage at all", hero.ring === "\u2014", hero.ring);
  // Folded in from the fix this branch is stacked on: the ring is not the
  // only place a percentage could appear, and the headline is the thing
  // somebody reads first.
  check("...nor does the headline beside it", !/%/.test(hero.text), hero.text);
  check("...drawn as an empty track, not a zero-length sweep", hero.sweeps === 1, hero.sweeps);

  console.log("\n== Priority for you ==");
  const prio = await page.evaluate(() => {
    const p = [...document.querySelectorAll(".bd-panel")].find((t) => /Priority for you/i.test(t.textContent));
    if (!p) return null;
    return {
      rows: [...p.querySelectorAll(".bd-prio")].map((r) => r.innerText.replace(/\s+/g, " ").trim()),
      calm: !!p.querySelector(".bd-calm"),
    };
  });
  check("the priority feed is on the page", !!prio, prio);
  // These fixtures carry an expired authorization and an overdue plan, so the
  // feed must not be empty -- an "all clear" on a caseload that is not clear
  // is the worst thing this panel could do.
  check("a caseload with an expired authorization is NOT reported as all clear",
    prio.rows.length > 0 && !prio.calm, prio);
  check("...and the reason is in words, not only a colour",
    prio.rows.some((r) => /expired|overdue|due in|no treatment plan|no student analyst/i.test(r)), prio.rows);
  check("...each one offers a way into the record it is about",
    await page.evaluate(() => [...document.querySelectorAll(".bd-prio")].every(
      (r) => r.hasAttribute("data-client") || r.hasAttribute("data-goto"))));

  console.log("\n== Caseload health ==");
  const health = await page.evaluate(() => {
    const segs = [...document.querySelectorAll("[data-health]")].map((b) => b.innerText.replace(/\s+/g, " ").trim());
    return { segs, dots: document.querySelectorAll(".bd-hcell").length };
  });
  check("the three health segments are offered", health.segs.length >= 3, health.segs);
  check("...they are labelled in words, not only coloured",
    health.segs.join(" ").match(/On track/i) && health.segs.join(" ").match(/attention/i)
      && health.segs.join(" ").match(/Action required/i), health.segs);
  check("every client row carries a health verdict", health.dots >= 3, health.dots);
  check("...and each explains itself on hover rather than leaving a bare dot",
    await page.evaluate(() => [...document.querySelectorAll(".bd-hcell")].every(
      (h) => (h.getAttribute("title") || "").length > 10)));

  // Pressing a segment filters the table that is already there. It must not
  // open a second caseload, and pressing it again must clear it.
  const filtered = await page.evaluate(async () => {
    const before = document.querySelectorAll("#bd-caseload tbody tr").length;
    const seg = document.querySelector('[data-health="action"]');
    seg.click();
    await new Promise((r) => setTimeout(r, 250));
    const after = document.querySelectorAll("#bd-caseload tbody tr").length;
    const tables = document.querySelectorAll("#bd-caseload table").length;
    document.querySelector('[data-health="action"]').click();
    await new Promise((r) => setTimeout(r, 250));
    return { before, after, tables, restored: document.querySelectorAll("#bd-caseload tbody tr").length };
  });
  check("a health segment narrows the caseload already on the page",
    filtered.after <= filtered.before && filtered.tables === 1, filtered);
  check("...and pressing it again clears the filter",
    filtered.restored === filtered.before, filtered);

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
  // My Schedule is a MONTH calendar now, so the controls step by month.
  check("the schedule has month controls", await page.locator("[data-month]").count() === 3);

  // THE GRID ITSELF NEEDS DATA, and a build environment has no Rethink
  // credentials -- the panel correctly says so instead of drawing an empty
  // month. So the month endpoint is stubbed here and the real rendering is
  // exercised against it. Without this the calendar would be shipped with its
  // only UI coverage being "the buttons exist", which is what let the previous
  // version of this check pass while saying nothing.
  {
    const MONTH = "2026-05";           // May 2026: the 1st is a Friday, 31 days
    await page.route("**/api/caseload/schedule*", async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.get("month")) return route.continue();
      const days = [];
      for (let n = 1; n <= 31; n++) {
        const iso = `${MONTH}-${String(n).padStart(2, "0")}`;
        const count = n === 4 ? 3 : n === 5 ? 1 : 0;
        days.push({
          date: iso, count, hours: count * 2,
          rows: Array.from({ length: count }, (_, i) => ({
            start: `${iso}T0${8 + i}:00:00`, end: `${iso}T0${9 + i}:00:00`, date: iso,
            client_id: null, client_name: null, rethink_client_id: "R" + i,
            location: "Clinic", service: "97153", status: "Scheduled", duration_hours: 2,
          })),
        });
      }
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          month: MONTH, from: `${MONTH}-01`, to: `${MONTH}-31`, available: true,
          source: "Rethink", staff_id: "S1", days, total_appointments: 4, total_hours: 8,
        }),
      });
    });
    // Nudge the panel into reloading through the stub.
    await page.evaluate(() => {
      const b = document.querySelector('[data-month="next"]');
      if (b) b.click();
    });
    await page.waitForSelector(".bd-cal-cell.sel", { timeout: 15000 }).catch(() => {});

    check("it draws a month calendar grid", await page.locator(".bd-cal").count() === 1);
    check("the grid is laid out Sunday to Saturday", await page.locator(".bd-cal-dow").count() === 7);
    check("every day of the month has a cell, quiet ones included",
      await page.locator("[data-cal-day]").count() === 31,
      await page.locator("[data-cal-day]").count());
    check("the 1st sits under its real weekday",
      await page.locator(".bd-cal-cell.pad").count() === 5,
      await page.locator(".bd-cal-cell.pad").count());
    check("a busy day shows how many appointments it has",
      (await page.locator('[data-cal-day="2026-05-04"] .bd-cal-pill').textContent()) === "3");
    check("a quiet day shows no count rather than a zero",
      await page.locator('[data-cal-day="2026-05-01"] .bd-cal-pill').count() === 0);

    const selDay = () => page.evaluate(() => {
      const el = document.querySelector(".bd-cal-cell.sel");
      return el ? el.getAttribute("data-cal-day") : null;
    });
    const before = await selDay();
    check("a day is selected", !!before, before);
    check("exactly one day is selected", await page.locator(".bd-cal-cell.sel").count() === 1);

    // Clicking a day must not refetch the month: the rows are already loaded,
    // and a spinner per click would make the calendar feel broken.
    await page.click('[data-cal-day="2026-05-04"]');
    let after = before;
    for (let i = 0; i < 40 && after !== "2026-05-04"; i++) {
      await page.waitForTimeout(100);
      after = await selDay();
    }
    check("clicking a day moves the selection", after === "2026-05-04", { before, after });
    check("and still exactly one day is selected", await page.locator(".bd-cal-cell.sel").count() === 1);
    check("the chosen day's appointments are listed underneath",
      /Clinic/.test(await page.locator("#bd-sched-body").innerText()),
      (await page.locator("#bd-sched-body").innerText()).slice(0, 160));

    await page.unroute("**/api/caseload/schedule*");
  }

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

  console.log("\n== Recent clinical activity ==");
  // Read from the rendered panel, so this passes only if the query actually
  // ran against the real schema and returned the row.
  const activity = await page.evaluate(() => {
    const p = [...document.querySelectorAll(".bd-panel")].find((t) => /Recent clinical activity/i.test(t.textContent));
    return p ? [...p.querySelectorAll(".bd-act")].map((r) => r.innerText.replace(/\s+/g, " ").trim()) : null;
  });
  check("the activity panel is on the page", Array.isArray(activity), activity);
  check("A COMPLETED TASK ON THIS CASELOAD REACHES THE ACTIVITY FEED",
    (activity || []).some((r) => /Draft the reauthorization packet/.test(r)), activity);
  check("...naming the client it was about",
    (activity || []).some((r) => /Draft the reauthorization packet/.test(r) && /Caseload Alpha/.test(r)), activity);

  console.log("\n== Presentation ==");
  // EMOJI: NARROWED, NOT DROPPED. The rule used to be none at all, and it was
  // a good rule -- emoji scattered through deadlines and percentages make a
  // clinical screen look like a chat app. What was asked for is positive
  // reinforcement on the two panels that are about something going right.
  //
  // So the rule now says WHERE, which is the part that was actually load
  // bearing. A 🎉 beside a met weekly goal is what was asked for; a 🎉 in the
  // caseload table is the thing the original check existed to stop.
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2728}\u{2B50}\u{1F3C6}]/gu;
  const stray = await page.evaluate((src) => {
    const re = new RegExp(src, "gu");
    const zones = [
      ["the caseload table", "#bd-caseload table"],
      ["the priority feed", ".bd-prio"],
      ["the summary tiles", ".bd-tile"],
      ["the authorizations panel", ".bd-panel table"],
      ["the calendar", ".bd-cal"],
    ];
    const out = [];
    for (const [label, sel] of zones) {
      document.querySelectorAll(sel).forEach((el) => {
        const m = (el.textContent || "").match(re);
        if (m) out.push(label + ": " + m.join(""));
      });
    }
    return out;
  }, emojiRe.source);
  check("NO EMOJI ANYWHERE CLINICAL DATA IS READ — tables, priorities, tiles, calendar",
    stray.length === 0, stray);

  // And where they ARE allowed, they are a fixed short list rather than
  // whatever anybody felt like adding.
  const allEmoji = [...new Set((await page.innerHTML(".bd")).match(emojiRe) || [])];
  const ALLOWED = ["🎉", "✨", "🌟", "🏆", "🌱", "📋"];
  check("...and the ones that are used are from the approved set",
    allEmoji.every((e) => ALLOWED.includes(e)), allEmoji);
  const wide = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
  check("nothing overflows horizontally", wide.doc <= wide.win + 1, wide);
  await page.setViewportSize({ width: 480, height: 900 });
  await page.waitForTimeout(400);
  // WHAT THIS CHECKS, AND WHY IT IS NOT THE DOCUMENT WIDTH.
  //
  // The measurement that matters for this feature is whether the dashboard fits
  // the column the app gives it. The document is 9px wider than a 480px
  // viewport, and that is NOT this section: nothing in .bd extends past the
  // viewport unclipped, and .app-shell measures exactly 480 with the sidebar at
  // 272 and the main column at 208.
  //
  // The sidebar is the story there. It is written `width: 240px` with
  // `padding: 24px 16px`, and the app's global border-box rule never applies --
  // a stray declaration after the :root block makes the CSS parser swallow it --
  // so it renders 272px. Every screen in this CRM is 32px narrower than it was
  // drawn to be, and on a phone the sidebar takes more than half the display.
  // Fixing that shifts layout on every screen and belongs in its own change.
  //
  // So this asserts the honest thing: the dashboard does not overflow the
  // column it was given, and the shell measurement is reported alongside so the
  // app-wide problem stays visible rather than being quietly absorbed here.
  const narrow = await page.evaluate(() => {
    const win = window.innerWidth;
    const main = document.querySelector(".main");
    const bd = document.querySelector(".bd");
    const clipped = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return true;
      }
      return false;
    };
    let over = null;
    document.querySelectorAll(".bd *").forEach((el) => {
      const r = el.getBoundingClientRect();
      const past = Math.round(r.right - win);
      if (past > 1 && !clipped(el) && (!over || past > over.past)) {
        over = { past, tag: el.tagName.toLowerCase(), cls: String(el.className || "").slice(0, 50) };
      }
    });
    const w = (n) => (n ? Math.round(n.getBoundingClientRect().width) : null);
    return {
      win, over,
      section: bd ? bd.scrollWidth : null,
      column: w(main),
      shell: { app: w(document.querySelector(".app-shell")), sidebar: w(document.querySelector(".sidebar")), main: w(main) },
      doc: document.documentElement.scrollWidth,
    };
  });
  check("NOTHING IN THE DASHBOARD SPILLS OUT OF ITS COLUMN ON A PHONE",
    narrow.over === null, narrow);
  check("and the section fits the column it was given",
    narrow.section !== null && narrow.column !== null && narrow.section <= narrow.column + 1, narrow);
  // Reported, not asserted: this is the fixed 240px-declared sidebar rendering
  // at 272px, which is an app-wide layout bug and not this feature's to fix.
  if (narrow.doc > narrow.win + 1) {
    console.log(`  NOTE  the page is ${narrow.doc}px at a ${narrow.win}px viewport -- app shell, ` +
      `sidebar ${narrow.shell.sidebar}px (declared 240px, border-box never applies). Not this section.`);
  }

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
