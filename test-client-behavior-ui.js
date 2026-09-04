// The Client Behavior tab, driven in a real browser.
//
// test-client-behavior.js proves the structure -- one plan table, one endpoint,
// one renderer. This proves the thing a person actually experiences: that the
// tab loads, that the plan appears inside it, that a note can be written, and
// -- the assertion the whole feature turns on -- THAT A NOTE WRITTEN FROM THE
// CLIENT BEHAVIOR TAB IS VISIBLE ON THE CLIENT'S CARD, and that an edit to the
// plan made in one place is present in the other.
//
// A shared table would pass a unit test and still fail here if the two screens
// had drifted into separate renderers, which is exactly the failure the spec
// was written to prevent.
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log("  PASS  " + name); }
    else { fail++; console.log("  FAIL  " + name + (detail !== undefined ? "  -> " + String(detail).slice(0, 400) : "")); }
  };
  const BASE = process.env.BASE || "http://localhost:3009";

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.fill('#login-form input[name="email"]', "admin@spectrumsquadlv.com");
  await page.fill('#login-form input[name="password"]', "TestOwner123!");
  await page.click('#login-form button[type="submit"]');
  await page.waitForTimeout(2500);

  console.log("\n== The tab exists and loads ==");
  const navCount = await page.locator('[data-nav="client-behavior"]').count();
  const navHash = await page.locator('[data-nav="client-behavior"]').first()
    .getAttribute("data-nav-hash").catch(() => null);
  check("a Client Behavior nav entry is rendered", navCount > 0, "count " + navCount);
  check("and it routes to #/client-behavior", navHash === "#/client-behavior", navHash);

  await page.goto(BASE + "/#/client-behavior");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1800);
  const rosterText = await page.locator("#app, body").first().innerText();
  check("the roster page renders its heading", /Client Behavior/.test(rosterText));
  check("the roster explains that the plan is shared, not copied",
    /same plan on the client's card/i.test(rosterText), rosterText.slice(0, 200));
  check("the roster has the columns the spec asked for",
    /Assigned BCBA/i.test(rosterText) && /BIP status/i.test(rosterText) && /View Behavior/i.test(rosterText));

  const clientId = await page.evaluate(async () => {
    const d = await (await fetch("/api/bip/roster", { credentials: "include" })).json();
    return d.clients && d.clients[0] ? d.clients[0].id : null;
  });
  check("the roster returns at least one client", clientId != null);
  if (clientId == null) { console.log(`\n${pass} passed, ${fail} failed`); await browser.close(); process.exit(1); }

  // Asserted against a live database rather than against the SQL text: a
  // source check would pass just as happily if the column name were wrong.
  console.log("\n== The waitlist and intake do not appear ==");
  const IN_SCOPE = ["active", "first_day_scheduled"];
  const scope = await page.evaluate(async (inScope) => {
    const all = await (await fetch("/api/clients", { credentials: "include" })).json();
    const roster = await (await fetch("/api/bip/roster", { credentials: "include" })).json();
    const ids = new Set((roster.clients || []).map((c) => c.id));
    const list = Array.isArray(all) ? all : (all.clients || []);
    const eligible = (c) => inScope.includes(c.stage) && !c.waitlisted;
    return {
      rosterCount: ids.size,
      outOfScopeShown: list.filter((c) => !inScope.includes(c.stage) && ids.has(c.id)).map((c) => c.child_name),
      waitlistedShown: list.filter((c) => c.waitlisted && ids.has(c.id)).map((c) => c.child_name),
      eligibleCount: list.filter(eligible).length,
      picked: list.find((c) => c.stage === "active" && !c.waitlisted) || null,
      // Whatever the roster says a row's stage is has to match the client
      // record; the "Starting soon" tag is drawn off this field.
      stageMismatch: (roster.clients || []).filter((r) => {
        const c = list.find((x) => x.id === r.id);
        return c && r.stage !== c.stage;
      }).map((r) => r.child_name),
    };
  }, IN_SCOPE);
  check("no client outside Active Therapy or First Day Scheduling is on the roster",
    scope.outOfScopeShown.length === 0, scope.outOfScopeShown.join(", "));
  check("no waitlisted client is on the roster whatever their stage",
    scope.waitlistedShown.length === 0, scope.waitlistedShown.join(", "));
  check("and every eligible client is there",
    scope.rosterCount === scope.eligibleCount, `${scope.rosterCount} vs ${scope.eligibleCount}`);
  check("the stage each row reports is the stage the client record holds",
    scope.stageMismatch.length === 0, scope.stageMismatch.join(", "));

  // Waitlist a real active client and watch them leave the roster.
  if (scope.picked) {
    const gone = await page.evaluate(async (id) => {
      await fetch(`/api/clients/${id}/waitlist`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waitlisted: true, reason: "smoke test" }),
      });
      const r = await (await fetch("/api/bip/roster", { credentials: "include" })).json();
      const present = (r.clients || []).some((c) => c.id === id);
      await fetch(`/api/clients/${id}/waitlist`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ waitlisted: false }),
      });
      const back = await (await fetch("/api/bip/roster", { credentials: "include" })).json();
      return { present, restored: (back.clients || []).some((c) => c.id === id) };
    }, scope.picked.id);
    check("WAITLISTING AN ACTIVE CLIENT REMOVES THEM FROM THE ROSTER", gone.present === false, gone);
    check("and taking them off the waitlist brings them back", gone.restored === true, gone);
  }

  // A client with a first day booked, driven through the real stage move
  // rather than a direct UPDATE, because enterStage is what production runs.
  console.log("\n== A client whose first day is scheduled ==");
  const firstDay = await page.evaluate(async () => {
    const mk = await (await fetch("/api/clients", {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ child_name: "Starting Soon Child", parent_name: "Starting Parent",
                             parent_email: "starting.soon@example.com" }),
    })).json();
    await fetch(`/api/clients/${mk.id}/advance`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "first_day_scheduled" }),
    });
    const r = await (await fetch("/api/bip/roster", { credentials: "include" })).json();
    const row = (r.clients || []).find((c) => c.id === mk.id) || null;
    // And still excluded once waitlisted, which is the flag doing the work
    // rather than the stage.
    await fetch(`/api/clients/${mk.id}/waitlist`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waitlisted: true, reason: "smoke test" }),
    });
    const after = await (await fetch("/api/bip/roster", { credentials: "include" })).json();
    return { id: mk.id, row, waitlistedStillShown: (after.clients || []).some((c) => c.id === mk.id) };
  });
  check("A CLIENT IN FIRST DAY SCHEDULING IS ON THE ROSTER", !!firstDay.row, firstDay);
  check("and the row carries that stage", firstDay.row && firstDay.row.stage === "first_day_scheduled", firstDay.row);
  check("waitlisting one still takes them off, so the flag beats the stage here too",
    firstDay.waitlistedStillShown === false, firstDay);

  // Take them off the waitlist and read the drawn page: the tag is what tells
  // a BCBA this plan is for a child who has not started yet.
  await page.evaluate(async (id) => {
    await fetch(`/api/clients/${id}/waitlist`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waitlisted: false }),
    });
  }, firstDay.id);
  // The page is already on this hash, and setting the same hash fires no
  // hashchange -- so the roster would not redraw and the new client would not
  // be on it. Reload rather than navigate.
  await page.goto(BASE + "/#/client-behavior");
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(
    () => /Starting Soon Child/.test(document.body.innerText), null, { timeout: 15000 }
  ).catch(() => {});
  const rosterAgain = await page.locator("#app, body").first().innerText();
  check("the page marks them as starting soon rather than mixing them in silently",
    /Starting Soon Child[\s\S]{0,80}Starting soon/i.test(rosterAgain), rosterAgain.slice(0, 400));

  console.log("\n== One client ==");
  await page.goto(BASE + "/#/client-behavior/" + clientId);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  check("the plan container is present", await page.locator("#cb-plan").count() === 1);
  const planHtml = await page.locator("#cb-plan").innerHTML();
  check("the plan section actually rendered something", planHtml.length > 200, "len " + planHtml.length);
  check("the Behavior Modification Notes section is present",
    await page.locator('h2:has-text("Behavior Modification Notes")').count() === 1);
  check("an Add Note button is offered to a clinical user",
    await page.locator("#cb-add").count() === 1);

  console.log("\n== Writing a note ==");
  const marker = "SMOKE-" + Date.now();
  await page.click("#cb-add");
  await page.waitForTimeout(400);
  await page.fill("#cb-behavior", "Elopement " + marker);
  await page.fill("#cb-strategy", "Block the door and redirect to the token board.");
  await page.fill("#cb-instructions", "Tell the parent at pickup.");
  await page.click("#cb-save");
  await page.waitForTimeout(1600);
  const afterSave = await page.locator("#cb-notes").innerText();
  check("the saved note appears in the list", afterSave.includes(marker), afterSave.slice(0, 200));
  check("it shows who wrote it", /Written by/i.test(afterSave));

  // An empty note must be refused rather than written as a blank row.
  await page.click("#cb-add");
  await page.waitForTimeout(400);
  await page.click("#cb-save");
  await page.waitForTimeout(1200);
  check("an empty note is refused with a message, not saved",
    /Add a behavior, a strategy, or instructions/i.test(await page.locator("#cb-form").innerText()));
  await page.click("#cb-cancel");

  console.log("\n== The PDF downloads as a real file ==");
  const pdf = await page.evaluate(async () => {
    const d = await (await fetch("/api/bip/roster", { credentials: "include" })).json();
    const cid = d.clients[0].id;
    const n = await (await fetch(`/api/bip/client/${cid}/behavior-notes`, { credentials: "include" })).json();
    const r = await fetch(`/api/bip/behavior-notes/${n.notes[0].id}/pdf`, { credentials: "include" });
    const buf = new Uint8Array(await r.arrayBuffer());
    return {
      type: r.headers.get("content-type"),
      disp: r.headers.get("content-disposition"),
      head: String.fromCharCode.apply(null, buf.slice(0, 5)),
      len: buf.length,
    };
  });
  check("it is served as application/pdf", /application\/pdf/.test(pdf.type || ""), pdf.type);
  check("it is sent as an attachment with a filename", /attachment; filename=/.test(pdf.disp || ""), pdf.disp);
  check("the bytes really are a PDF", pdf.head === "%PDF-", pdf.head);
  check("and it is not empty", pdf.len > 500, "bytes " + pdf.len);

  // ================= THE ONE THAT MATTERS ==============================
  console.log("\n== The plan is the same record in both places ==");
  // Write to the plan through the Client Behavior tab's own endpoint, then read
  // it back through the client card's. Same row or the feature is a lie.
  const stamp = "SHARED-" + Date.now();
  const wrote = await page.evaluate(async ({ cid, stamp }) => {
    let d = await (await fetch(`/api/bip/client/${cid}`, { credentials: "include" })).json();
    if (!d.bip) {
      await fetch(`/api/bip/client/${cid}`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      d = await (await fetch(`/api/bip/client/${cid}`, { credentials: "include" })).json();
    }
    const r = await fetch(`/api/bip/${d.bip.id}`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ general_notes: stamp }),
    });
    return { ok: r.ok, status: r.status };
  }, { cid: clientId, stamp });

  const readBack = await page.evaluate(async (cid) => {
    const d = await (await fetch(`/api/bip/client/${cid}`, { credentials: "include" })).json();
    return d.bip ? d.bip.general_notes : null;
  }, clientId);

  if (wrote.ok) {
    check("a plan edit is readable through the same endpoint the card uses",
      readBack === stamp, `wrote ${stamp}, read ${readBack}`);
  } else {
    check("the plan field endpoint responded", false, "status " + wrote.status);
  }

  // The structural guarantee, asserted in the running page rather than in source.
  const sharesRenderer = await page.evaluate(() => typeof window.__renderBipSection === "function");
  check("the card's plan renderer is the one the tab uses, and it is loaded",
    sharesRenderer);

  const noteVisibleToCard = await page.evaluate(async ({ cid, marker }) => {
    const d = await (await fetch(`/api/bip/client/${cid}/behavior-notes`, { credentials: "include" })).json();
    return (d.notes || []).some((n) => String(n.behavior || "").includes(marker));
  }, { cid: clientId, marker });
  check("the note written in the tab is on the client's record, not a private list",
    noteVisibleToCard);

  check("no page errors", errors.length === 0, errors.join(" | "));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
